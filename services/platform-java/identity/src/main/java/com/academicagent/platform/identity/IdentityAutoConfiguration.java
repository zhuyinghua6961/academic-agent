package com.academicagent.platform.identity;

import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

@Configuration
@ComponentScan(basePackages = "com.academicagent.platform.identity")
@EntityScan(basePackages = "com.academicagent.platform.identity.entity")
@EnableJpaRepositories(basePackages = "com.academicagent.platform.identity.repository")
public class IdentityAutoConfiguration {
}
