package com.academicagent.platform.research.mapper;

import java.util.List;

import com.academicagent.platform.research.entity.Project;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface ProjectMapper extends BaseMapper<Project> {

    default List<Project> findByUserIdOrderByCreatedAtDesc(String userId) {
        return selectList(Wrappers.<Project>lambdaQuery()
                .eq(Project::getUserId, userId)
                .orderByDesc(Project::getCreatedAt));
    }
}
