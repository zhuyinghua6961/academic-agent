package com.academicagent.platform.identity.mapper;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.identity.entity.SearchSetting;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface SearchSettingMapper extends BaseMapper<SearchSetting> {

    default List<SearchSetting> findByUserId(String userId) {
        return selectList(Wrappers.<SearchSetting>lambdaQuery().eq(SearchSetting::getUserId, userId));
    }

    default Optional<SearchSetting> findByUserIdAndSource(String userId, String source) {
        return Optional.ofNullable(selectOne(Wrappers.<SearchSetting>lambdaQuery()
                .eq(SearchSetting::getUserId, userId)
                .eq(SearchSetting::getSource, source)));
    }
}
